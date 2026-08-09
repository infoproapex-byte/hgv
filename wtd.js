(function () {
  "use strict";

  var RING_CIRC = 238.76;
  var WTD_LIMIT_SEC = 6 * 3600;         // must not work more than 6 hrs without a break
  var MIN_BREAK_TO_RESET_SEC = 15 * 60; // a break under 15 min doesn't reset the 6-hr clock
  var REGULAR_DAILY_LIMIT_SEC = 13 * 3600; // shift spread max after 11h+ rest
  var REDUCED_DAILY_LIMIT_SEC = 15 * 3600; // shift spread max after 9-10h reduced rest
  var MAX_REDUCED_RESTS_PER_WEEK = 3;
  var STORAGE_KEY = "wtd_week_v1";

  var state = "idle"; // idle | working | break
  var shiftStartMs = null;
  var restType = "regular"; // regular | reduced
  var dailyLimitSec = REGULAR_DAILY_LIMIT_SEC;
  var countedThisShift = false; // whether this shift's rest type has been added to the weekly tally

  var workAccumSec = 0;
  var lastResumeMs = null;

  var breaks = [];
  var breakStartMs = null;
  var breakTargetSec = null; // null = free break, otherwise 30*60 or 45*60

  var notified = {}; // one-shot flags so we don't spam the same alert twice per shift

  // Defensive binder: if a file version mismatch ever leaves an element
  // missing from the page, this skips it instead of throwing and killing
  // every button wired up after it.
  function on(el, evt, fn) {
    if (el) el.addEventListener(evt, fn);
  }

  var startRow = document.getElementById("startRow");
  var mainBtn = document.getElementById("mainBtn");
  var endShiftBtn = document.getElementById("endShiftBtn");

  var reminderBtn = document.getElementById("reminderBtn");
  var reminderDot = document.getElementById("reminderDot");
  var reminderBtnLabel = document.getElementById("reminderBtnLabel");
  var reminderToast = document.getElementById("reminderToast");
  var wakeLockBadge = document.getElementById("wakeLockBadge");

  var breakPresets = document.getElementById("breakPresets");
  var preset30Btn = document.getElementById("preset30Btn");
  var preset45Btn = document.getElementById("preset45Btn");
  var freeBreakBtn = document.getElementById("freeBreakBtn");
  var activeBreakCard = document.getElementById("activeBreakCard");
  var breakTimerEl = document.getElementById("breakTimerEl");
  var breakTargetEl = document.getElementById("breakTargetEl");
  var endBreakBtn = document.getElementById("endBreakBtn");

  var restTypeRow = document.getElementById("restTypeRow");
  var restRegularBtn = document.getElementById("restRegularBtn");
  var restReducedBtn = document.getElementById("restReducedBtn");
  var restTypeWarn = document.getElementById("restTypeWarn");

  var reducedCountEl = document.getElementById("reducedCount");
  var weekHintEl = document.getElementById("weekHint");
  var cycleEditBtn = document.getElementById("cycleEditBtn");
  var cycleSettings = document.getElementById("cycleSettings");
  var cycleWorkDaysInput = document.getElementById("cycleWorkDays");
  var cycleRestDaysInput = document.getElementById("cycleRestDays");
  var cycleStartDateInput = document.getElementById("cycleStartDate");
  var cycleSaveBtn = document.getElementById("cycleSaveBtn");

  var shiftCard = document.getElementById("shiftCard");
  var wtdCard = document.getElementById("wtdCard");
  var shiftTimeEl = document.getElementById("shiftTime");
  var shiftStartLabel = document.getElementById("shiftStartLabel");
  var shiftBreaksTotal = document.getElementById("shiftBreaksTotal");
  var dailyLimitLabel = document.getElementById("dailyLimitLabel");
  var dailyRemainingEl = document.getElementById("dailyRemaining");
  var dailyMessageEl = document.getElementById("dailyMessage");

  var wtdRemainingEl = document.getElementById("wtdRemaining");
  var wtdMessageEl = document.getElementById("wtdMessage");
  var ringFg = document.getElementById("ringFg");

  var logTitle = document.getElementById("logTitle");
  var logList = document.getElementById("logList");
  var emptyLog = document.getElementById("emptyLog");

  // ---------- Reminders (native notifications + in-page toast fallback) ----------

  var RSTORAGE_KEY = "wtd_reminders_v1";
  var remindersEnabled = false;
  try { remindersEnabled = localStorage.getItem(RSTORAGE_KEY) === "1"; } catch (e) { /* ignore */ }

  var toastTimer = null;

  function showToast(msg) {
    if (!reminderToast) return;
    reminderToast.textContent = msg;
    reminderToast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      reminderToast.classList.add("hidden");
    }, 6000);
  }

  function renderReminderBtn() {
    if (!reminderBtn) return;
    reminderBtn.classList.toggle("on", remindersEnabled);
    reminderBtn.setAttribute("aria-pressed", remindersEnabled ? "true" : "false");
    if (reminderBtnLabel) reminderBtnLabel.textContent = remindersEnabled ? "Reminders on" : "Reminders off";
  }

  function notify(title, body) {
    // Always show the in-page toast so it works even if native notifications
    // are blocked or the tab doesn't have permission yet.
    showToast(title + (body ? " — " + body : ""));

    if (!remindersEnabled) return;
    if (typeof Notification === "undefined") return;

    if (Notification.permission === "granted") {
      try {
        var n = new Notification(title, { body: body, tag: "wtd-" + title });
        setTimeout(function () { n.close(); }, 15000);
      } catch (e) { /* some browsers restrict Notification() outside a SW; toast already shown */ }
    }
  }

  on(reminderBtn, "click", function () {
    if (!remindersEnabled) {
      if (typeof Notification === "undefined") {
        remindersEnabled = true;
        showToast("Native notifications aren't supported here — you'll still get on-screen reminders.");
      } else if (Notification.permission === "granted") {
        remindersEnabled = true;
        showToast("Reminders on. We'll ping you for breaks and limits.");
      } else if (Notification.permission === "denied") {
        remindersEnabled = true;
        showToast("Notifications are blocked in your browser settings — you'll still get on-screen reminders.");
      } else {
        Notification.requestPermission().then(function (perm) {
          remindersEnabled = true;
          if (perm === "granted") {
            showToast("Reminders on. We'll ping you for breaks and limits.");
          } else {
            showToast("Reminders on (on-screen only) — allow notifications for alerts when the app is in the background.");
          }
          try { localStorage.setItem(RSTORAGE_KEY, "1"); } catch (e) { /* ignore */ }
          renderReminderBtn();
        });
        return;
      }
    } else {
      remindersEnabled = false;
      showToast("Reminders off.");
    }

    try { localStorage.setItem(RSTORAGE_KEY, remindersEnabled ? "1" : "0"); } catch (e) { /* ignore */ }
    renderReminderBtn();
  });

  renderReminderBtn();

  // ---------- Keep screen on during an active shift (Screen Wake Lock API) ----------
  // Requires HTTPS. Fails silently on unsupported browsers or if the OS
  // denies it — the 6-hour clock keeps counting correctly either way,
  // this just stops the phone from dimming/locking on its own.

  var wakeLock = null;

  function updateWakeLockBadge() {
    if (wakeLockBadge) wakeLockBadge.classList.toggle("hidden", !wakeLock);
  }

  function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;

    navigator.wakeLock.request("screen").then(function (lock) {
      wakeLock = lock;
      updateWakeLockBadge();
      lock.addEventListener("release", function () {
        wakeLock = null;
        updateWakeLockBadge();
      });
    }).catch(function () {
      // Permission denied, battery saver on, or unsupported browser — ignore.
    });
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(function () { /* ignore */ });
      wakeLock = null;
      updateWakeLockBadge();
    }
  }

  document.addEventListener("visibilitychange", function () {
    // The OS force-releases the wake lock whenever the tab is hidden
    // (screen off, app switched away). Grab it again the moment the
    // driver comes back, as long as a shift is still running.
    if (document.visibilityState === "visible" && state !== "idle") {
      requestWakeLock();
    }
  });

  function pad(n) { return String(n).padStart(2, "0"); }

  function fmtHMS(totalSec) {
    totalSec = Math.max(0, Math.floor(totalSec));
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    return pad(h) + ":" + pad(m) + ":" + pad(s);
  }

  function fmtMS(totalSec) {
    totalSec = Math.max(0, Math.floor(totalSec));
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return m + ":" + pad(s);
  }

  function fmtClock(d) {
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function fmtDate(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  // ---------- Rota-cycle tracking (custom work/rest pattern, not Mon-Sun), persisted in localStorage ----------

  var CYCLE_KEY = "wtd_cycle_pattern_v1";

  function parseDateOnly(str) {
    var parts = str.split("-");
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  }

  function loadCyclePattern() {
    try {
      var raw = localStorage.getItem(CYCLE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && p.anchor && p.workDays && p.restDays) return p;
      }
    } catch (e) { /* ignore, fall through to default */ }
    // Default for this driver: 5 days on / 3 days off, current work
    // block started Thursday 2026-08-06 (3 days worked as of 2026-08-08).
    return { anchor: "2026-08-06", workDays: 5, restDays: 3 };
  }

  function saveCyclePattern(p) {
    try { localStorage.setItem(CYCLE_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
  }

  var cyclePattern = loadCyclePattern();

  function cycleLenDays() {
    return cyclePattern.workDays + cyclePattern.restDays;
  }

  function currentCycleStart() {
    var anchor = parseDateOnly(cyclePattern.anchor);
    anchor.setHours(0, 0, 0, 0);
    var len = cycleLenDays();
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var daysSince = Math.round((today - anchor) / 86400000);
    var idx = Math.floor(daysSince / len);
    var start = new Date(anchor);
    start.setDate(start.getDate() + idx * len);
    return start;
  }

  function cycleDayInfo() {
    var start = currentCycleStart();
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var dayNum = Math.round((today - start) / 86400000) + 1; // 1-indexed within the cycle
    var len = cycleLenDays();
    var phase = dayNum <= cyclePattern.workDays ? "work" : "rest";
    return { dayNum: dayNum, cycleLen: len, phase: phase, start: start };
  }

  function loadWeekData() {
    var thisCycleStart = fmtDate(currentCycleStart());
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data.cycleStart === thisCycleStart) {
          return data;
        }
      }
    } catch (e) { /* ignore, fall through to fresh cycle */ }
    return { cycleStart: thisCycleStart, reducedCount: 0 };
  }

  function saveWeekData(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* storage unavailable, continue without persistence */ }
  }

  var weekData = loadWeekData();

  function renderWeekCard() {
    weekData = loadWeekData(); // re-check in case the cycle rolled over
    reducedCountEl.textContent = weekData.reducedCount;
    reducedCountEl.parentElement.classList.toggle(
      "maxed", weekData.reducedCount >= MAX_REDUCED_RESTS_PER_WEEK
    );

    var info = cycleDayInfo();
    var nextStart = new Date(info.start);
    nextStart.setDate(nextStart.getDate() + info.cycleLen);

    var phaseLabel = info.phase === "work"
      ? "Work day " + info.dayNum + "/" + cyclePattern.workDays
      : "Rest day " + (info.dayNum - cyclePattern.workDays) + "/" + cyclePattern.restDays;

    weekHintEl.textContent = phaseLabel + " · new cycle starts " + fmtDate(nextStart);
  }

  if (cycleWorkDaysInput) cycleWorkDaysInput.value = cyclePattern.workDays;
  if (cycleRestDaysInput) cycleRestDaysInput.value = cyclePattern.restDays;
  if (cycleStartDateInput) cycleStartDateInput.value = cyclePattern.anchor;

  on(cycleEditBtn, "click", function () {
    cycleSettings.classList.toggle("hidden");
  });

  on(cycleSaveBtn, "click", function () {
    var wd = parseInt(cycleWorkDaysInput.value, 10);
    var rd = parseInt(cycleRestDaysInput.value, 10);
    var anchor = cycleStartDateInput.value;

    if (!anchor || !(wd > 0) || !(rd > 0)) {
      showToast("Fill in work days, rest days and a start date first.");
      return;
    }

    cyclePattern = { anchor: anchor, workDays: wd, restDays: rd };
    saveCyclePattern(cyclePattern);
    cycleSettings.classList.add("hidden");
    renderWeekCard();
    showToast("Work pattern saved — " + wd + " on, " + rd + " off.");
  });

  // ---------- Backup export / import (protects against lost browser storage) ----------

  var exportBackupBtn = document.getElementById("exportBackupBtn");
  var importBackupBtn = document.getElementById("importBackupBtn");
  var importBackupInput = document.getElementById("importBackupInput");

  var BACKUP_KEYS = [STORAGE_KEY, CYCLE_KEY, "wtd_reminders_v1", "roadtalk_server"];

  on(exportBackupBtn, "click", function () {
    var data = {};
    BACKUP_KEYS.forEach(function (key) {
      try {
        var val = localStorage.getItem(key);
        if (val !== null) data[key] = val;
      } catch (e) { /* ignore */ }
    });

    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "roadtalk-backup-" + fmtDate(new Date()) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Backup saved to your downloads.");
  });

  on(importBackupBtn, "click", function () {
    importBackupInput.click();
  });

  on(importBackupInput, "change", function () {
    var file = importBackupInput.files && importBackupInput.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        BACKUP_KEYS.forEach(function (key) {
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            localStorage.setItem(key, data[key]);
          }
        });
        cyclePattern = loadCyclePattern();
        if (cycleWorkDaysInput) cycleWorkDaysInput.value = cyclePattern.workDays;
        if (cycleRestDaysInput) cycleRestDaysInput.value = cyclePattern.restDays;
        if (cycleStartDateInput) cycleStartDateInput.value = cyclePattern.anchor;
        renderWeekCard();
        showToast("Backup restored.");
      } catch (e) {
        showToast("That file doesn't look like a valid RoadTalk backup.");
      }
      importBackupInput.value = "";
    };
    reader.readAsText(file);
  });

  var hourCol = document.getElementById("hourCol");
  var minuteCol = document.getElementById("minuteCol");
  var ITEM_H = 44;

  var selectedHour = new Date().getHours();
  var selectedMinute = new Date().getMinutes();

  function buildWheel(col, count, onSelect) {
    var topPad = document.createElement("div");
    topPad.className = "wtd-time-col-pad";
    col.appendChild(topPad);

    for (var i = 0; i < count; i++) {
      var item = document.createElement("div");
      item.className = "wtd-time-item";
      item.textContent = pad(i);
      item.dataset.val = i;
      col.appendChild(item);
    }

    var bottomPad = document.createElement("div");
    bottomPad.className = "wtd-time-col-pad";
    col.appendChild(bottomPad);

    var scrollTimer = null;

    function highlightCenter(snap) {
      var index = Math.round(col.scrollTop / ITEM_H);
      index = Math.max(0, Math.min(count - 1, index));

      if (snap) {
        col.scrollTo({ top: index * ITEM_H, behavior: "smooth" });
      }

      var items = col.querySelectorAll(".wtd-time-item");
      items.forEach(function (el) { el.classList.remove("selected"); });
      var current = col.querySelector('.wtd-time-item[data-val="' + index + '"]');
      if (current) current.classList.add("selected");

      onSelect(index);
    }

    col.addEventListener("scroll", function () {
      highlightCenter(false);
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function () { highlightCenter(true); }, 120);
    });

    return highlightCenter;
  }

  var setHourHighlight = buildWheel(hourCol, 24, function (v) { selectedHour = v; });
  var setMinuteHighlight = buildWheel(minuteCol, 60, function (v) { selectedMinute = v; });

  function setWheelTo(hour, minute) {
    hourCol.scrollTop = hour * ITEM_H;
    minuteCol.scrollTop = minute * ITEM_H;
    setHourHighlight(false);
    setMinuteHighlight(false);
  }

  setWheelTo(selectedHour, selectedMinute);
  requestAnimationFrame(function () { setWheelTo(selectedHour, selectedMinute); });

  // ---------- Rest type selector ----------

  function selectRestType(type) {
    restType = type;
    restRegularBtn.classList.toggle("on", type === "regular");
    restReducedBtn.classList.toggle("on", type === "reduced");

    if (type === "reduced" && weekData.reducedCount >= MAX_REDUCED_RESTS_PER_WEEK) {
      restTypeWarn.classList.remove("hidden");
    } else {
      restTypeWarn.classList.add("hidden");
    }
  }

  on(restRegularBtn, "click", function () { selectRestType("regular"); });
  on(restReducedBtn, "click", function () { selectRestType("reduced"); });

  // ---------- Main render loop ----------

  function totalBreakSec() {
    var sum = breaks.reduce(function (a, b) { return a + b.durationSec; }, 0);
    if (state === "break" && breakStartMs) {
      sum += (Date.now() - breakStartMs) / 1000;
    }
    return sum;
  }

  function shiftSpreadSec() {
    if (!shiftStartMs) return 0;
    return (Date.now() - shiftStartMs) / 1000;
  }

  function currentWorkAccumSec() {
    var sec = workAccumSec;
    if (state === "working" && lastResumeMs) {
      sec += (Date.now() - lastResumeMs) / 1000;
    }
    return sec;
  }

  function render() {
    if (state === "idle") {
      renderWeekCard();
      return;
    }

    var spread = shiftSpreadSec();
    shiftTimeEl.textContent = fmtHMS(spread);
    shiftBreaksTotal.textContent = Math.round(totalBreakSec() / 60) + " min";

    var dailyRemaining = dailyLimitSec - spread;
    dailyRemainingEl.textContent = fmtMS(Math.max(0, dailyRemaining));

    if (dailyRemaining <= 30 * 60) {
      dailyMessageEl.className = "wtd-daily-msg urgent";
      dailyMessageEl.textContent = "Urgent: " + Math.ceil(dailyRemaining / 60) +
        " min left until your " + (dailyLimitSec / 3600) + "-hour daily limit. Start looking for parking now.";
      if (!notified.daily30 && dailyRemaining > 0) {
        notified.daily30 = true;
        notify("30 min to your daily limit", "Start looking for parking now.");
      }
    } else if (dailyRemaining <= 60 * 60) {
      dailyMessageEl.className = "wtd-daily-msg warn";
      dailyMessageEl.textContent = Math.ceil(dailyRemaining / 60) +
        " min left until your " + (dailyLimitSec / 3600) + "-hour daily limit. Start planning where to stop.";
      if (!notified.daily60 && dailyRemaining > 0) {
        notified.daily60 = true;
        notify("1 hour to your daily limit", "Start planning where to stop.");
      }
    } else {
      dailyMessageEl.className = "wtd-daily-msg ok";
      dailyMessageEl.textContent = "Plenty of time left before your " + (dailyLimitSec / 3600) + "-hour daily limit.";
    }

    var worked = currentWorkAccumSec();
    var remaining = WTD_LIMIT_SEC - worked;
    wtdRemainingEl.textContent = fmtMS(Math.max(0, remaining));

    var frac = Math.max(0, Math.min(1, remaining / WTD_LIMIT_SEC));
    ringFg.style.strokeDashoffset = RING_CIRC * (1 - frac);

    if (state === "break") {
      ringFg.style.stroke = "var(--text-muted)";
      wtdMessageEl.className = "wtd-msg ok";
      wtdMessageEl.textContent = "On break. This clock is paused.";
    } else if (remaining <= 5 * 60) {
      ringFg.style.stroke = "var(--alert-red)";
      wtdMessageEl.className = "wtd-msg urgent";
      wtdMessageEl.textContent = "Urgent: " + Math.ceil(remaining / 60) + " minutes left until the 6-hour limit.";
      if (!notified.wtd5) {
        notified.wtd5 = true;
        notify("5 min until your 6-hour limit", "Take a break now.");
      }
    } else if (remaining <= 15 * 60) {
      ringFg.style.stroke = "var(--amber)";
      wtdMessageEl.className = "wtd-msg warn";
      wtdMessageEl.textContent = "15 minutes left. Take your break now.";
      if (!notified.wtd15) {
        notified.wtd15 = true;
        notify("15 min left before a break is due", "Start looking for a place to stop.");
      }
    } else if (remaining <= 30 * 60) {
      ringFg.style.stroke = "var(--amber)";
      wtdMessageEl.className = "wtd-msg warn";
      wtdMessageEl.textContent = "30 minutes left until you must take a break.";
      if (!notified.wtd30) {
        notified.wtd30 = true;
        notify("30 min left before a break is due", "");
      }
    } else if (remaining <= 45 * 60) {
      ringFg.style.stroke = "var(--amber)";
      wtdMessageEl.className = "wtd-msg warn";
      wtdMessageEl.textContent = "45 minutes left. Plan your break.";
    } else {
      ringFg.style.stroke = "var(--signal-green)";
      wtdMessageEl.className = "wtd-msg ok";
      wtdMessageEl.textContent = "Working time under monitoring. No break needed yet.";
    }

    renderBreakUI();
  }

  function renderBreakUI() {
    if (!breakPresets || !activeBreakCard) return;

    if (state === "break") {
      breakPresets.classList.add("hidden");
      activeBreakCard.classList.remove("hidden");

      var elapsed = (Date.now() - breakStartMs) / 1000;

      if (breakTargetSec) {
        var left = breakTargetSec - elapsed;
        if (left <= 0) {
          breakTimerEl.textContent = "00:00";
          breakTargetEl.textContent = "Break's done — back to work when you are.";
          breakTargetEl.className = "wtd-break-target done";
          if (!notified.breakDone) {
            notified.breakDone = true;
            notify("Break finished", "Time to get back on the road.");
          }
        } else {
          breakTimerEl.textContent = fmtMS(left);
          breakTargetEl.textContent = (breakTargetSec / 60) + " min break — counting down";
          breakTargetEl.className = "wtd-break-target";
        }
      } else {
        breakTimerEl.textContent = fmtMS(elapsed);
        breakTargetEl.textContent = "Free break — end whenever you're ready";
        breakTargetEl.className = "wtd-break-target";
      }
    } else {
      activeBreakCard.classList.add("hidden");
      if (state === "working") {
        breakPresets.classList.remove("hidden");
      } else {
        breakPresets.classList.add("hidden");
      }
    }
  }

  function renderLog() {
    if (breaks.length === 0) {
      emptyLog.classList.remove("hidden");
      logList.innerHTML = "";
      logList.appendChild(emptyLog);
      return;
    }
    logList.innerHTML = breaks.map(function (b, i) {
      var resetTag = b.durationSec >= MIN_BREAK_TO_RESET_SEC
        ? '<span class="wtd-log-reset">reset 6h clock</span>' : "";
      return '<div class="wtd-log-item"><div class="wtd-log-type">Break ' + (i + 1) + resetTag + '</div>' +
        '<div class="wtd-log-time">' + fmtClock(b.startDate) + ' \u2013 ' + fmtClock(b.endDate) +
        ' \u00b7 ' + Math.round(b.durationSec / 60) + ' min</div></div>';
    }).join("");
  }

  function showActiveUI() {
    restTypeRow.classList.add("hidden");
    startRow.classList.add("hidden");
    shiftCard.classList.remove("hidden");
    wtdCard.classList.remove("hidden");
    if (breakPresets) breakPresets.classList.remove("hidden");
    logTitle.classList.remove("hidden");
    endShiftBtn.classList.remove("hidden");
  }

  function resetAll() {
    state = "idle";
    shiftStartMs = null;
    workAccumSec = 0;
    lastResumeMs = null;
    breaks = [];
    breakStartMs = null;
    breakTargetSec = null;
    countedThisShift = false;
    notified = {};
    releaseWakeLock();

    restTypeRow.classList.remove("hidden");
    startRow.classList.remove("hidden");
    shiftCard.classList.add("hidden");
    wtdCard.classList.add("hidden");
    if (breakPresets) breakPresets.classList.add("hidden");
    if (activeBreakCard) activeBreakCard.classList.add("hidden");
    logTitle.classList.add("hidden");
    endShiftBtn.classList.add("hidden");

    selectRestType("regular");
    renderLog();
    renderWeekCard();

    var now = new Date();
    setWheelTo(now.getHours(), now.getMinutes());
  }

  on(mainBtn, "click", function () {
    var start = new Date();
    start.setHours(selectedHour, selectedMinute, 0, 0);
    shiftStartMs = start.getTime();

    dailyLimitSec = restType === "reduced" ? REDUCED_DAILY_LIMIT_SEC : REGULAR_DAILY_LIMIT_SEC;
    dailyLimitLabel.textContent = dailyLimitSec / 3600;

    if (restType === "reduced" && !countedThisShift) {
      weekData.reducedCount += 1;
      saveWeekData(weekData);
      countedThisShift = true;
    }

    shiftStartLabel.textContent = fmtClock(new Date(shiftStartMs));
    state = "working";
    lastResumeMs = Date.now();
    workAccumSec = 0;
    requestWakeLock();

    showActiveUI();
    renderLog();
    render();
  });

  function startBreak(targetMin) {
    if (state !== "working") return;

    if (lastResumeMs) {
      workAccumSec += (Date.now() - lastResumeMs) / 1000;
      lastResumeMs = null;
    }
    state = "break";
    breakStartMs = Date.now();
    breakTargetSec = targetMin ? targetMin * 60 : null;
    notified.breakDone = false;

    if (targetMin) {
      notify(targetMin + " min break started", "We'll ping you when it's up.");
    }

    render();
  }

  function endBreak() {
    if (state !== "break") return;

    var durationSec = (Date.now() - breakStartMs) / 1000;
    breaks.push({
      startDate: new Date(breakStartMs),
      endDate: new Date(),
      durationSec: durationSec
    });

    if (durationSec >= MIN_BREAK_TO_RESET_SEC) {
      workAccumSec = 0;
    }

    breakStartMs = null;
    breakTargetSec = null;
    state = "working";
    lastResumeMs = Date.now();
    renderLog();
    render();
  }

  on(preset30Btn, "click", function () { startBreak(30); });
  on(preset45Btn, "click", function () { startBreak(45); });
  on(freeBreakBtn, "click", function () { startBreak(null); });
  on(endBreakBtn, "click", endBreak);

  on(endShiftBtn, "click", function () {
    if (confirm("End shift and clear today's data? Your weekly reduced-rest count is kept.")) {
      resetAll();
    }
  });

  resetAll();
  setInterval(render, 1000);
})();

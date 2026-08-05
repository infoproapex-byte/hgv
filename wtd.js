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

  var startRow = document.getElementById("startRow");
  var mainBtn = document.getElementById("mainBtn");
  var breakBtn = document.getElementById("breakBtn");
  var endShiftBtn = document.getElementById("endShiftBtn");

  var restTypeRow = document.getElementById("restTypeRow");
  var restRegularBtn = document.getElementById("restRegularBtn");
  var restReducedBtn = document.getElementById("restReducedBtn");
  var restTypeWarn = document.getElementById("restTypeWarn");

  var reducedCountEl = document.getElementById("reducedCount");
  var weekHintEl = document.getElementById("weekHint");

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

  // ---------- Week tracking (Mon 00:00 - Sun 24:00), persisted in localStorage ----------

  function mondayOf(date) {
    var d = new Date(date);
    var day = d.getDay(); // 0 = Sunday
    var diff = (day === 0 ? -6 : 1) - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function loadWeekData() {
    var thisMonday = fmtDate(mondayOf(new Date()));
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data.weekStart === thisMonday) {
          return data;
        }
      }
    } catch (e) { /* ignore, fall through to fresh week */ }
    return { weekStart: thisMonday, reducedCount: 0 };
  }

  function saveWeekData(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* storage unavailable, continue without persistence */ }
  }

  var weekData = loadWeekData();

  function renderWeekCard() {
    weekData = loadWeekData(); // re-check in case the week rolled over
    reducedCountEl.textContent = weekData.reducedCount;
    reducedCountEl.parentElement.classList.toggle(
      "maxed", weekData.reducedCount >= MAX_REDUCED_RESTS_PER_WEEK
    );
    var nextMonday = new Date(mondayOf(new Date()));
    nextMonday.setDate(nextMonday.getDate() + 7);
    weekHintEl.textContent = "Week of " + weekData.weekStart + " · resets Monday";
  }

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

  restRegularBtn.addEventListener("click", function () { selectRestType("regular"); });
  restReducedBtn.addEventListener("click", function () { selectRestType("reduced"); });

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
    } else if (dailyRemaining <= 60 * 60) {
      dailyMessageEl.className = "wtd-daily-msg warn";
      dailyMessageEl.textContent = Math.ceil(dailyRemaining / 60) +
        " min left until your " + (dailyLimitSec / 3600) + "-hour daily limit. Start planning where to stop.";
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
    } else if (remaining <= 15 * 60) {
      ringFg.style.stroke = "var(--amber)";
      wtdMessageEl.className = "wtd-msg warn";
      wtdMessageEl.textContent = "15 minutes left. Take your break now.";
    } else if (remaining <= 30 * 60) {
      ringFg.style.stroke = "var(--amber)";
      wtdMessageEl.className = "wtd-msg warn";
      wtdMessageEl.textContent = "30 minutes left until you must take a break.";
    } else if (remaining <= 45 * 60) {
      ringFg.style.stroke = "var(--amber)";
      wtdMessageEl.className = "wtd-msg warn";
      wtdMessageEl.textContent = "45 minutes left. Plan your break.";
    } else {
      ringFg.style.stroke = "var(--signal-green)";
      wtdMessageEl.className = "wtd-msg ok";
      wtdMessageEl.textContent = "Working time under monitoring. No break needed yet.";
    }

    if (state === "break") {
      breakBtn.textContent = "End break";
      breakBtn.className = "wtd-primary-btn break-end";
    } else {
      breakBtn.textContent = "Start break";
      breakBtn.className = "wtd-primary-btn break-start";
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
    breakBtn.classList.remove("hidden");
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
    countedThisShift = false;

    restTypeRow.classList.remove("hidden");
    startRow.classList.remove("hidden");
    shiftCard.classList.add("hidden");
    wtdCard.classList.add("hidden");
    breakBtn.classList.add("hidden");
    logTitle.classList.add("hidden");
    endShiftBtn.classList.add("hidden");

    selectRestType("regular");
    renderLog();
    renderWeekCard();

    var now = new Date();
    setWheelTo(now.getHours(), now.getMinutes());
  }

  mainBtn.addEventListener("click", function () {
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

    showActiveUI();
    renderLog();
    render();
  });

  breakBtn.addEventListener("click", function () {
    if (state === "working") {
      if (lastResumeMs) {
        workAccumSec += (Date.now() - lastResumeMs) / 1000;
        lastResumeMs = null;
      }
      state = "break";
      breakStartMs = Date.now();
    } else if (state === "break") {
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
      state = "working";
      lastResumeMs = Date.now();
      renderLog();
    }
    render();
  });

  endShiftBtn.addEventListener("click", function () {
    if (confirm("End shift and clear today's data? Your weekly reduced-rest count is kept.")) {
      resetAll();
    }
  });

  resetAll();
  setInterval(render, 1000);
})();

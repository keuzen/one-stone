(function () {
  "use strict";

  const DB_NAME = "one-stone";
  const DB_VERSION = 1;
  const SETTINGS_STORE = "settings";
  const RECORDS_STORE = "records";
  const HABIT_KEY = "habit";
  const TERMS_CONSENT_KEY = "terms-consent";
  const TERMS_VERSION = "v2";
  const GA_MEASUREMENT_ID = "G-QW6L40SBLK";

  let database;
  let currentHabit;
  let todayKey = getDateKey(new Date());
  let termsEndReached = false;
  let analyticsLoadPromise;
  let analyticsEnabled = false;

  const elements = {};

  document.addEventListener("DOMContentLoaded", function () {
    elements.appMain = document.getElementById("app-main");
    elements.termsModal = document.getElementById("terms-modal");
    elements.termsScroll = document.getElementById("terms-scroll");
    elements.termsRead = document.getElementById("terms-read");
    elements.termsAgree = document.getElementById("terms-agree");
    elements.termsError = document.getElementById("terms-error");
    elements.setupSection = document.getElementById("setup-section");
    elements.setupForm = document.getElementById("setup-form");
    elements.tableSection = document.getElementById("table-section");
    elements.habitColumn = document.getElementById("habit-column");
    elements.recordsBody = document.getElementById("records-body");
    elements.emptyState = document.getElementById("empty-state");
    elements.recordTableContainer = document.getElementById("record-table-container");
    elements.tableStatus = document.getElementById("table-status");
    elements.todayRecord = document.getElementById("today-record");
    elements.error = document.getElementById("app-error");

    elements.setupForm.addEventListener("submit", handleHabitSubmit);
    elements.recordsBody.addEventListener("change", handleRecordChange);
    elements.todayRecord.addEventListener("click", handleTodayRecord);
    elements.termsScroll.addEventListener("scroll", handleTermsScroll);
    elements.termsRead.addEventListener("change", handleTermsReadChange);
    elements.termsAgree.addEventListener("click", handleTermsAgree);
    document.addEventListener("keydown", handleTermsKeydown);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    initialise();
  });

  async function initialise() {
    try {
      database = await openDatabase();
      const termsConsent = await getTermsConsent();

      if (!termsConsent) {
        showTermsModal();
        return;
      }

      unlockApp();
      analyticsEnabled = true;
      startAnalytics();
      await loadAppState();
    } catch (error) {
      trackError("app_initialization");
      elements.appMain.hidden = false;
      showError("このブラウザに記録を保存できません。IndexedDBが利用できる環境で開いてください。");
      console.error(error);
    }
  }

  async function loadAppState() {
    currentHabit = await getHabit();
    const entryState = currentHabit ? "existing" : "new";
    trackEvent("one_stone_app_ready", { entry_state: entryState });

    if (currentHabit) {
      renderHabit(currentHabit);
      await refreshRecords();
    } else {
      showSetup();
    }
  }

  function openDatabase() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB is not available."));
        return;
      }

      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function () {
        const upgradedDatabase = request.result;

        if (!upgradedDatabase.objectStoreNames.contains(SETTINGS_STORE)) {
          upgradedDatabase.createObjectStore(SETTINGS_STORE, { keyPath: "id" });
        }

        if (!upgradedDatabase.objectStoreNames.contains(RECORDS_STORE)) {
          upgradedDatabase.createObjectStore(RECORDS_STORE, { keyPath: "date" });
        }
      };

      request.onsuccess = function () {
        const openedDatabase = request.result;
        openedDatabase.onversionchange = function () {
          openedDatabase.close();
        };
        resolve(openedDatabase);
      };

      request.onerror = function () {
        reject(request.error || new Error("Could not open the database."));
      };
    });
  }

  function requestAsPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error("IndexedDB request failed."));
      };
    });
  }

  function getHabit() {
    const transaction = database.transaction(SETTINGS_STORE, "readonly");
    return requestAsPromise(transaction.objectStore(SETTINGS_STORE).get(HABIT_KEY));
  }

  function getTermsConsent() {
    const transaction = database.transaction(SETTINGS_STORE, "readonly");
    return requestAsPromise(transaction.objectStore(SETTINGS_STORE).get(TERMS_CONSENT_KEY)).then(function (consent) {
      if (!consent || consent.termsVersion !== TERMS_VERSION || consent.agreed !== true) {
        return null;
      }
      return consent;
    });
  }

  function saveHabit(habit) {
    const transaction = database.transaction(SETTINGS_STORE, "readwrite");
    return requestAsPromise(transaction.objectStore(SETTINGS_STORE).put(habit));
  }

  function saveTermsConsent() {
    const transaction = database.transaction(SETTINGS_STORE, "readwrite");
    return requestAsPromise(transaction.objectStore(SETTINGS_STORE).put({
      id: TERMS_CONSENT_KEY,
      agreed: true,
      termsVersion: TERMS_VERSION,
      agreedAt: new Date().toISOString()
    }));
  }

  function getRecords() {
    const transaction = database.transaction(RECORDS_STORE, "readonly");
    return requestAsPromise(transaction.objectStore(RECORDS_STORE).getAll());
  }

  function saveRecord(date, checked) {
    return new Promise(function (resolve, reject) {
      const transaction = database.transaction(RECORDS_STORE, "readwrite");
      const store = transaction.objectStore(RECORDS_STORE);
      const getRequest = store.get(date);

      getRequest.onsuccess = function () {
        const now = new Date().toISOString();
        const record = getRequest.result || {
          date: date,
          createdAt: now
        };

        record.checked = checked;
        record.checkedAt = checked ? now : null;
        record.updatedAt = now;

        const putRequest = store.put(record);
        putRequest.onsuccess = function () {
          resolve(record);
        };
        putRequest.onerror = function () {
          reject(putRequest.error || new Error("Could not save the record."));
        };
      };

      getRequest.onerror = function () {
        reject(getRequest.error || new Error("Could not read the record."));
      };
      transaction.onerror = function () {
        reject(transaction.error || new Error("Could not update the record."));
      };
      transaction.onabort = function () {
        reject(transaction.error || new Error("The record transaction was aborted."));
      };
    });
  }

  function createTodayRecord() {
    return new Promise(function (resolve, reject) {
      const transaction = database.transaction(RECORDS_STORE, "readwrite");
      const store = transaction.objectStore(RECORDS_STORE);
      const getRequest = store.get(todayKey);

      getRequest.onsuccess = function () {
        if (getRequest.result) {
          resolve(getRequest.result);
          return;
        }

        const now = new Date().toISOString();
        const putRequest = store.put({
          date: todayKey,
          checked: false,
          checkedAt: null,
          createdAt: now,
          updatedAt: now
        });

        putRequest.onsuccess = function () {
          resolve(putRequest.result);
        };
        putRequest.onerror = function () {
          reject(putRequest.error || new Error("Could not create today's record."));
        };
      };

      getRequest.onerror = function () {
        reject(getRequest.error || new Error("Could not read today's record."));
      };
      transaction.onerror = function () {
        reject(transaction.error || new Error("Could not create today's record."));
      };
      transaction.onabort = function () {
        reject(transaction.error || new Error("Today's record transaction was aborted."));
      };
    });
  }

  async function handleHabitSubmit(event) {
    event.preventDefault();
    clearError();

    const formData = new FormData(elements.setupForm);
    const name = String(formData.get("habitName") || "").trim();
    const condition = String(formData.get("condition") || "").trim();
    const criteria = String(formData.get("criteria") || "").trim();

    if (!name || !condition || !criteria) {
      showError("習慣名、実行条件、完了基準をすべて入力してください。");
      return;
    }

    const now = new Date().toISOString();
    const habit = {
      id: HABIT_KEY,
      name: name,
      condition: condition,
      criteria: criteria,
      createdAt: now,
      updatedAt: now
    };

    try {
      await saveHabit(habit);
      currentHabit = habit;
      trackEvent("one_stone_setup_complete");
      renderHabit(currentHabit);
      await refreshRecords();
    } catch (error) {
      trackError("indexeddb_write");
      showError("習慣を保存できませんでした。もう一度試してください。");
      console.error(error);
    }
  }

  async function handleTodayRecord() {
    if (!database || !currentHabit) {
      return;
    }

    elements.todayRecord.disabled = true;
    clearError();

    try {
      await createTodayRecord();
      await refreshRecords();
      announce("今日の記録欄を作成しました。");
    } catch (error) {
      trackError("indexeddb_write");
      elements.todayRecord.disabled = false;
      showError("今日の記録欄を作成できませんでした。もう一度試してください。");
      console.error(error);
    }
  }

  async function handleRecordChange(event) {
    const checkbox = event.target.closest("input[data-date]");
    if (!checkbox || checkbox.dataset.date !== todayKey) {
      return;
    }

    const checked = checkbox.checked;
    checkbox.disabled = true;
    clearError();

    try {
      await saveRecord(todayKey, checked);
      trackEvent(checked ? "one_stone_check_add" : "one_stone_check_cancel");
      announce(checked ? "今日の実行を記録しました。" : "今日の記録を取り消しました。");
      await refreshRecords();
    } catch (error) {
      checkbox.checked = !checked;
      trackError("indexeddb_write");
      showError("今日の記録を更新できませんでした。もう一度試してください。");
      console.error(error);
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState !== "visible") {
      return;
    }

    const nextTodayKey = getDateKey(new Date());
    if (nextTodayKey === todayKey || !database || !currentHabit) {
      return;
    }

    todayKey = nextTodayKey;
    refreshRecords().catch(function (error) {
      trackError("indexeddb_read");
      showError("今日の記録を読み込めませんでした。");
      console.error(error);
    });
  }

  function renderHabit(habit) {
    elements.setupSection.hidden = true;
    elements.tableSection.hidden = false;
    elements.habitColumn.textContent = habit.name;
    elements.habitColumn.title = habit.name;
    trackEvent("one_stone_record_view");
  }

  function showSetup() {
    elements.setupSection.hidden = false;
    elements.tableSection.hidden = true;
    trackEvent("one_stone_setup_view");
  }

  function showTermsModal() {
    termsEndReached = false;
    elements.termsRead.checked = false;
    elements.termsRead.disabled = true;
    elements.termsAgree.disabled = true;
    elements.termsError.hidden = true;
    elements.termsError.textContent = "";
    elements.termsModal.hidden = false;
    document.body.classList.add("terms-open");
    window.requestAnimationFrame(function () {
      updateTermsEndState();
      elements.termsScroll.focus();
    });
  }

  function unlockApp() {
    elements.termsModal.hidden = true;
    elements.appMain.hidden = false;
    document.body.classList.remove("terms-open");
  }

  function handleTermsScroll() {
    updateTermsEndState();
  }

  function updateTermsEndState() {
    if (termsEndReached) {
      return;
    }

    const reachedEnd = elements.termsScroll.scrollTop + elements.termsScroll.clientHeight >= elements.termsScroll.scrollHeight - 4;
    if (!reachedEnd) {
      return;
    }

    termsEndReached = true;
    elements.termsRead.disabled = false;
  }

  function handleTermsReadChange() {
    elements.termsAgree.disabled = !termsEndReached || !elements.termsRead.checked;
  }

  async function handleTermsAgree() {
    if (!termsEndReached || !elements.termsRead.checked || elements.termsAgree.disabled) {
      return;
    }

    elements.termsAgree.disabled = true;
    elements.termsError.hidden = true;
    elements.termsError.textContent = "";

    try {
      await saveTermsConsent();
      unlockApp();
      analyticsEnabled = true;
      startAnalytics();
      trackEvent("one_stone_terms_agree", { terms_version: TERMS_VERSION });
      await loadAppState();
      if (!currentHabit) {
        document.getElementById("habit-name").focus();
      }
    } catch (error) {
      trackError("app_initialization");
      elements.termsAgree.disabled = false;
      if (elements.termsModal.hidden) {
        showError("アプリを読み込めませんでした。ページを再読み込みしてください。");
      } else {
        elements.termsError.textContent = "同意状態を保存できませんでした。もう一度試してください。";
        elements.termsError.hidden = false;
      }
      console.error(error);
    }
  }

  function handleTermsKeydown(event) {
    if (!elements.termsModal || elements.termsModal.hidden || event.key !== "Escape") {
      return;
    }

    event.preventDefault();
  }

  function trackEvent(eventName, parameters) {
    if (!analyticsEnabled || typeof window.gtag !== "function") {
      return;
    }

    if (parameters) {
      window.gtag("event", eventName, parameters);
    } else {
      window.gtag("event", eventName);
    }
  }

  function trackError(errorType) {
    trackEvent("one_stone_error", { error_type: errorType });
  }

  function startAnalytics() {
    loadAnalytics().catch(function (error) {
      console.warn("Google Analytics could not be loaded.", error);
    });
  }

  function loadAnalytics() {
    if (analyticsLoadPromise) {
      return analyticsLoadPromise;
    }

    analyticsLoadPromise = new Promise(function (resolve, reject) {
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () {
        window.dataLayer.push(arguments);
      };

      window.gtag("js", new Date());
      window.gtag("config", GA_MEASUREMENT_ID, {
        send_page_view: true
      });

      const script = document.createElement("script");
      script.async = true;
      script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GA_MEASUREMENT_ID);
      script.dataset.oneStoneAnalytics = "true";
      script.onload = function () {
        resolve();
      };
      script.onerror = function () {
        reject(new Error("Google Analytics script could not be loaded."));
      };
      document.head.appendChild(script);
    });

    return analyticsLoadPromise;
  }

  async function refreshRecords() {
    const records = await getRecords();
    renderRecordTable(records);
  }

  function renderRecordTable(records) {
    const recordByDate = new Map();

    records.forEach(function (record) {
      if (record.date <= todayKey) {
        recordByDate.set(record.date, record);
      }
    });

    const dates = Array.from(recordByDate.keys()).sort(function (first, second) {
      return second.localeCompare(first);
    });

    elements.recordsBody.textContent = "";

    dates.forEach(function (date) {
      const row = document.createElement("tr");
      if (date === todayKey) {
        row.className = "is-today";
      }

      const dateCell = document.createElement("td");
      const dateLabel = document.createElement("time");
      dateLabel.dateTime = date;
      dateLabel.textContent = formatDate(date);
      dateCell.append(dateLabel);

      const checkCell = document.createElement("td");
      checkCell.className = "check-cell";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = isRecordChecked(recordByDate.get(date));
      checkbox.dataset.date = date;
      checkbox.disabled = date !== todayKey;
      checkbox.setAttribute("aria-label", formatDate(date) + "の実行");

      checkCell.append(checkbox);
      row.append(dateCell, checkCell);
      elements.recordsBody.append(row);
    });

    const hasRecords = dates.length > 0;
    elements.emptyState.hidden = hasRecords;
    elements.recordTableContainer.hidden = !hasRecords;
    elements.todayRecord.hidden = recordByDate.has(todayKey);
    elements.todayRecord.disabled = false;
  }

  function isRecordChecked(record) {
    if (!record) {
      return false;
    }

    return record.checked === true || (record.checked === undefined && Boolean(record.checkedAt));
  }

  function getDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function formatDate(dateKey) {
    return dateKey.replace(/-/g, "/");
  }

  function announce(message) {
    elements.tableStatus.textContent = message;
  }

  function showError(message) {
    elements.error.textContent = message;
    elements.error.hidden = false;
  }

  function clearError() {
    elements.error.textContent = "";
    elements.error.hidden = true;
  }
})();
